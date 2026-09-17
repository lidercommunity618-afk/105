import type {
  Candle,
  IndicatorConfig,
  FeatureName,
  Signal,
  Timeframe,
  Tick,
  Snapshot,
} from '@/types/domain';
import type { CalibrationModel } from '@/decision/calibration-model';
import { buildFullSnapshot } from '@/compute/full-snapshot';
import { buildSignal, type BuildSignalParams } from '@/decision/signal-builder';

export interface EngineInput {
  symbolId: string;
  timeframe: Timeframe;
  candles: Candle[];
  config: IndicatorConfig;
  activeFeatures: FeatureName[];
  calibration: CalibrationModel | null;
  tick: Tick | null;
  barsToResolve: number;
}

export interface EngineOutput {
  signal: Signal | null;
  snapshot: Snapshot;
}

export function runEngine(input: EngineInput): EngineOutput {
  const { snapshot } = buildFullSnapshot(input.candles, input.config, input.activeFeatures);
  const signal = buildSignal({
    symbolId: input.symbolId,
    timeframe: input.timeframe,
    candles: input.candles,
    config: input.config,
    activeFeatures: input.activeFeatures,
    snapshot,
    calibration: input.calibration,
    tick: input.tick,
    barsToResolve: input.barsToResolve,
  } satisfies BuildSignalParams);
  return { signal, snapshot };
}

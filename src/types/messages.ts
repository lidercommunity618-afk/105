import type {
  Candle,
  CalibrationResult,
  IndicatorConfig,
  IndicatorSnapshot,
  IndicatorSeries,
  Snapshot,
  Timeframe,
  FeatureName,
} from './domain';
import type { CalibrationSample } from '@/decision/calibration-model';

export function genRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Inbound (main → worker) ──────────────────────────────────────

export type WorkerInboundMessage =
  | {
      type: 'candle_closed';
      requestId: string;
      symbolId: string;
      timeframe: Timeframe;
      candles: Candle[];
      config: IndicatorConfig;
      activeFeatures: FeatureName[];
      isClosed: boolean;
    }
  | {
      type: 'snapshot_request';
      requestId: string;
      symbolId: string;
      timeframe: Timeframe;
      candles: Candle[];
      config: IndicatorConfig;
      activeFeatures: FeatureName[];
      isClosed: boolean;
    }
  | {
      type: 'tick_update';
      requestId: string;
      symbolId: string;
      timeframe: Timeframe;
      candles: Candle[];
      config: IndicatorConfig;
      activeFeatures: FeatureName[];
    }
  | {
      type: 'reset_streaming';
      requestId: string;
    }
  | {
      type: 'calibrate';
      requestId: string;
      symbolId: string;
      timeframe: Timeframe;
      candles: Candle[];
      config: IndicatorConfig;
    }
  | {
      type: 'retrain_calibration';
      requestId: string;
      samples: CalibrationSample[];
      featureCount: number;
    };

// ─── Outbound (worker → main) ─────────────────────────────────────

export type WorkerOutboundMessage =
  | {
      type: 'candle_closed_result';
      requestId: string;
      snapshot: Snapshot;
      series: IndicatorSeries;
    }
  | {
      type: 'snapshot_result';
      requestId: string;
      snapshot: Snapshot;
      series: IndicatorSeries;
    }
  | {
      type: 'tick_update_result';
      requestId: string;
      snapshot: IndicatorSnapshot;
    }
  | {
      type: 'calibrate_result';
      requestId: string;
      result: CalibrationResult;
    }
  | {
      type: 'retrain_calibration_result';
      requestId: string;
      weights: number[];
      bias: number;
      // BUGFIX (аудит "калибровка: 0 сигналов после 100"): нормализация
      // признаков, посчитанная trainLogisticRegression вместе с weights —
      // должна прокидываться обратно к CalibrationModel.applyTrainedWeights()
      // без потерь, иначе predict() снова разъедется с тем, на чём weights
      // были обучены. См. calibration-model.ts.
      featureMean: number[];
      featureStd: number[];
    }
  | { type: 'worker_error'; requestId: string; message: string };

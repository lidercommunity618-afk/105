import type {
  Candle,
  CalibrationResult,
  IndicatorConfig,
  IndicatorSnapshot,
  IndicatorSeries,
  Snapshot,
  Timeframe,
  FeatureName,
} from '@/types/market';
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from '@/types/messages';
import { genRequestId } from '@/types/messages';
import type { CalibrationSample } from '@/decision/calibration-model';

interface PendingRequest {
  resolve: (msg: WorkerOutboundMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 3000;

const CALIBRATE_TIMEOUT_MS = 60000;

export class WorkerClient {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerOutboundMessage>) => {
      const msg = e.data;
      const req = this.pending.get(msg.requestId);
      if (!req) return;
      this.pending.delete(msg.requestId);
      clearTimeout(req.timer);
      if (msg.type === 'worker_error') {
        req.reject(new Error(msg.message));
      } else {
        req.resolve(msg);
      }
    };
    this.worker.onerror = (e) => {
      for (const [, req] of this.pending) {
        clearTimeout(req.timer);
        req.reject(new Error(e.message || 'worker error'));
      }
      this.pending.clear();
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }
    };
    return this.worker;
  }

  private send<T extends WorkerOutboundMessage>(
    message: WorkerInboundMessage,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const worker = this.ensureWorker();
    const requestId = genRequestId();
    const outbound: WorkerInboundMessage = { ...message, requestId };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('worker request timeout'));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (msg) => resolve(msg as T),
        reject,
        timer,
      });
      worker.postMessage(outbound);
    });
  }

  async candleClosed(
    symbolId: string,
    timeframe: Timeframe,
    candles: Candle[],
    config: IndicatorConfig,
    activeFeatures: FeatureName[],
    isClosed = true,
  ): Promise<{ snapshot: Snapshot; series: IndicatorSeries }> {
    const res = await this.send<Extract<WorkerOutboundMessage, { type: 'candle_closed_result' }>>({
      type: 'candle_closed',
      requestId: '',
      symbolId,
      timeframe,
      candles,
      config,
      activeFeatures,
      isClosed,
    });
    return { snapshot: res.snapshot, series: res.series };
  }

  async snapshotRequest(
    symbolId: string,
    timeframe: Timeframe,
    candles: Candle[],
    config: IndicatorConfig,
    activeFeatures: FeatureName[],
    isClosed = true,
  ): Promise<{ snapshot: Snapshot; series: IndicatorSeries }> {
    const res = await this.send<Extract<WorkerOutboundMessage, { type: 'snapshot_result' }>>({
      type: 'snapshot_request',
      requestId: '',
      symbolId,
      timeframe,
      candles,
      config,
      activeFeatures,
      isClosed,
    });
    return { snapshot: res.snapshot, series: res.series };
  }

  async tickUpdate(
    symbolId: string,
    timeframe: Timeframe,
    candles: Candle[],
    config: IndicatorConfig,
    activeFeatures: FeatureName[],
  ): Promise<IndicatorSnapshot> {
    const res = await this.send<Extract<WorkerOutboundMessage, { type: 'tick_update_result' }>>({
      type: 'tick_update',
      requestId: '',
      symbolId,
      timeframe,
      candles,
      config,
      activeFeatures,
    });
    return res.snapshot;
  }

  resetStreaming(): void {
    const worker = this.ensureWorker();
    worker.postMessage({ type: 'reset_streaming', requestId: genRequestId() });
  }

  async calibrate(
    symbolId: string,
    timeframe: Timeframe,
    candles: Candle[],
    config: IndicatorConfig,
  ): Promise<CalibrationResult> {
    const res = await this.send<Extract<WorkerOutboundMessage, { type: 'calibrate_result' }>>(
      {
        type: 'calibrate',
        requestId: '',
        symbolId,
        timeframe,
        candles,
        config,
      },
      CALIBRATE_TIMEOUT_MS,
    );
    return res.result;
  }

  // Same underlying computation as calibrate() (500-epoch full-batch gradient
  // descent), but for the CalibrationModel logistic regression rather than the
  // ATR-multiplier mini-backtest. Distinct operation, distinct timeout — do not
  // reuse CALIBRATE_TIMEOUT_MS here.
  async retrainCalibration(
    samples: CalibrationSample[],
    featureCount: number,
  ): Promise<{ weights: number[]; bias: number; featureMean: number[]; featureStd: number[] }> {
    const res = await this.send<Extract<WorkerOutboundMessage, { type: 'retrain_calibration_result' }>>({
      type: 'retrain_calibration',
      requestId: '',
      samples,
      featureCount,
    });
    // BUGFIX (аудит "калибровка: 0 сигналов после 100"): featureMean/
    // featureStd прокидываются насквозь к model.applyTrainedWeights() в
    // useTickStore.ts::triggerRetrain — см. calibration-model.ts.
    return { weights: res.weights, bias: res.bias, featureMean: res.featureMean, featureStd: res.featureStd };
  }

  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error('worker terminated'));
    }
    this.pending.clear();
  }
}

export const workerClient = new WorkerClient();

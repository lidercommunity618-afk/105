import type { Candle, Tick, Timeframe, ConnectionStatus, SourceId } from '@/types/domain';

export interface ConnectResult {
  candles: Candle[];
  source: SourceId;
}

export interface DataSource {
  readonly id: SourceId;
  connect(symbolId: string, timeframe: Timeframe): Promise<ConnectResult>;
  disconnect(): void;
  fetchHistory(symbolId: string, timeframe: Timeframe, count: number): Promise<Candle[]>;
  fetchServerTime(): Promise<number>;
  onTick(cb: (tick: Tick) => void): () => void;
  onCandle(cb: (candle: Candle, isClosed: boolean) => void): () => void;
  onStatus(cb: (status: ConnectionStatus) => void): () => void;
}

export const SYNTHETIC_SOURCE: SourceId = 'binance';

export function normalizeServerTime(t: number): number {
  if (t < 1e12) return t * 1000;
  return t;
}

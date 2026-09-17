import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_INDICATOR_CONFIG } from '@/types/domain';

type MessageHandler = (e: MessageEvent) => void;
type ErrorHandler = (e: ErrorEvent) => void;

class MockWorker {
  onmessage: MessageHandler | null = null;
  onerror: ErrorHandler | null = null;
  private terminated = false;
  private lastMessage: Record<string, unknown> | null = null;

  postMessage(msg: Record<string, unknown>): void {
    this.lastMessage = msg;
  }

  addEventListener(type: string, handler: MessageHandler | ErrorHandler): void {
    if (type === 'message') this.onmessage = handler as MessageHandler;
    if (type === 'error') this.onerror = handler as ErrorHandler;
  }

  removeEventListener(): void {}

  terminate(): void {
    this.terminated = true;
  }

  get isTerminated(): boolean {
    return this.terminated;
  }

  get lastSentMessage(): Record<string, unknown> | null {
    return this.lastMessage;
  }

  emit(data: unknown): void {
    if (this.onmessage) this.onmessage({ data } as MessageEvent);
  }

  emitError(message: string): void {
    if (this.onerror) this.onerror({ message } as ErrorEvent);
  }
}

const CONFIG = {
  ...DEFAULT_INDICATOR_CONFIG,
  rsiPeriod: 14, emaFast: 20, emaSlow: 50, macdFast: 12, macdSlow: 26,
  macdSignal: 9, atrPeriod: 14, bbPeriod: 20, bbStdDev: 2,
};

describe('WorkerClient', () => {
  let mockWorker: MockWorker;
  let originalWorker: typeof globalThis.Worker;

  beforeEach(() => {
    mockWorker = new MockWorker();
    originalWorker = globalThis.Worker;
    (globalThis as unknown as { Worker: unknown }).Worker = vi.fn(() => mockWorker);
    vi.resetModules();
  });

  afterEach(() => {
    (globalThis as unknown as { Worker: unknown }).Worker = originalWorker;
    vi.restoreAllMocks();
  });

  async function getClient() {
    const mod = await import('./WorkerClient');
    return new mod.WorkerClient();
  }

  it('sends a message and resolves on matching response', async () => {
    const client = await getClient();
    const promise = client.candleClosed('BTCUSDT', '15m', [], CONFIG, []);

    const sent = mockWorker.lastSentMessage;
    expect(sent).toBeDefined();
    expect(sent!.type).toBe('candle_closed');

    mockWorker.emit({
      type: 'candle_closed_result',
      requestId: sent!.requestId,
      snapshot: {
        indicators: {}, patterns: [], structure: {}, regime: 'range',
        lastPrice: null, candleTime: null,
      },
      series: {},
    });

    const result = await promise;
    expect(result).toBeDefined();
    expect(result.snapshot).toBeDefined();
    client.terminate();
  });

  it('rejects all pending requests on worker error', async () => {
    const client = await getClient();
    const promise = client.snapshotRequest('BTCUSDT', '15m', [], CONFIG, []);
    mockWorker.emitError('worker crashed');
    await expect(promise).rejects.toThrow('worker crashed');
  });

  it('terminate rejects all pending requests', async () => {
    const client = await getClient();
    const promise = client.tickUpdate('BTCUSDT', '15m', [], CONFIG, []);
    client.terminate();
    await expect(promise).rejects.toThrow('worker terminated');
  });

  it('terminate terminates the underlying worker', async () => {
    const client = await getClient();
    client.candleClosed('BTCUSDT', '15m', [], CONFIG, []).catch(() => {});
    client.terminate();
    expect(mockWorker.isTerminated).toBe(true);
  });

  it('ignores responses with unknown requestId', async () => {
    const client = await getClient();
    const promise = client.candleClosed('BTCUSDT', '15m', [], CONFIG, []);
    mockWorker.emit({
      type: 'candle_closed_result',
      requestId: 'nonexistent-id',
      snapshot: {}, series: {},
    });
    const settled = await Promise.race([
      promise.then(() => 'resolved'),
      new Promise<string>((r) => setTimeout(() => r('pending'), 100)),
    ]);
    expect(settled).toBe('pending');
    client.terminate();
  });
});

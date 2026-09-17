import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Candle, ConnectionStatus, SourceId, Symbol } from '@/types/domain';
import type { DataSource, ConnectResult } from '@/data/source';

function mockCandle(time: number): Candle {
  return { time, open: 100, high: 110, low: 90, close: 105, volume: 1000 };
}

function makeSource(id: SourceId, connectFn: () => Promise<ConnectResult>): DataSource {
  return {
    id,
    connect: () => connectFn(),
    disconnect: () => {},
    fetchHistory: () => Promise.resolve([mockCandle(0)]),
    fetchServerTime: () => Promise.resolve(Date.now()),
    onTick: () => () => {},
    onCandle: () => () => {},
    onStatus: (cb) => { cb('live'); return () => {}; },
  };
}

const cryptoSymbol: Symbol = {
  id: 'BTCUSDT',
  assetClass: 'crypto',
  displaySymbol: 'BTC/USDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  displayName: 'Bitcoin',
  pipSize: 0.01,
  marketHours: null,
};

const forexSymbol: Symbol = {
  id: 'EURUSD',
  assetClass: 'forex',
  displaySymbol: 'EUR/USD',
  baseAsset: 'EUR',
  quoteAsset: 'USD',
  displayName: 'Euro',
  pipSize: 0.00001,
  marketHours: null,
};

describe('ConnectionManager failover', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('falls over to the next source when the first fails', async () => {
    let binanceCalls = 0;
    let derivCalls = 0;
    const failing = makeSource('binance', () => Promise.reject(new Error('WS down')));
    const okResult: ConnectResult = {
      candles: [mockCandle(1), mockCandle(2)],
      source: 'deriv',
    };
    const working = makeSource('deriv', () => Promise.resolve(okResult));

    vi.doMock('@/data/factory', () => ({
      createSource: (id: SourceId) => {
        if (id === 'binance') { binanceCalls++; return failing; }
        derivCalls++;
        return working;
      },
    }));

    const { ConnectionManager } = await import('@/data/connection-manager');
    const mgr = new ConnectionManager();

    const result = await mgr.connectAndGetHistory(cryptoSymbol, '15m');
    expect(result.status).toBe('live');
    expect(result.source).toBe('deriv');
    expect(result.candles).toHaveLength(2);
    expect(binanceCalls).toBe(3);
    expect(derivCalls).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('returns failed status when all sources fail', async () => {
    const fail1 = makeSource('deriv', () => Promise.reject(new Error('down')));
    const fail2 = makeSource('twelvedata', () => Promise.reject(new Error('down')));
    const fail3 = makeSource('yahoo', () => Promise.reject(new Error('down')));
    const fail4 = makeSource('finnhub', () => Promise.reject(new Error('down')));

    vi.doMock('@/data/factory', () => ({
      createSource: (id: SourceId) => {
        if (id === 'deriv') return fail1;
        if (id === 'twelvedata') return fail2;
        if (id === 'yahoo') return fail3;
        return fail4;
      },
    }));

    const { ConnectionManager } = await import('@/data/connection-manager');
    const mgr = new ConnectionManager();

    const result = await mgr.connectAndGetHistory(forexSymbol, '15m');
    expect(result.status).toBe('failed');
    expect(result.candles).toEqual([]);
  }, 30000);

  it('exposes activeSource via public getter', async () => {
    const okResult: ConnectResult = {
      candles: [mockCandle(0)],
      source: 'binance',
    };
    const ok = makeSource('binance', () => Promise.resolve(okResult));

    vi.doMock('@/data/factory', () => ({
      createSource: () => ok,
    }));

    const { ConnectionManager } = await import('@/data/connection-manager');
    const mgr = new ConnectionManager();
    expect(mgr.activeSource).toBeNull();

    await mgr.connectAndGetHistory(cryptoSymbol, '15m');
    expect(mgr.activeSource).toBe('binance');
    mgr.disconnect();
    expect(mgr.activeSource).toBeNull();
  });

  it('propagates connection statuses to listeners', async () => {
    const okResult: ConnectResult = {
      candles: [mockCandle(0)],
      source: 'binance',
    };
    const ok = makeSource('binance', () => Promise.resolve(okResult));

    vi.doMock('@/data/factory', () => ({
      createSource: () => ok,
    }));

    const { ConnectionManager } = await import('@/data/connection-manager');
    const mgr = new ConnectionManager();
    const statuses: ConnectionStatus[] = [];
    mgr.onStatus((s) => statuses.push(s));

    await mgr.connectAndGetHistory(cryptoSymbol, '15m');
    mgr.disconnect();

    const statusSet = new Set(statuses);
    expect(statusSet.has('connecting')).toBe(true);
    expect(statusSet.has('live')).toBe(true);
    expect(statusSet.has('idle')).toBe(true);
  });

  // Аудит (синхронизация/двойная обработка): resync() (вызывается при
  // обнаруженном разрыве потока — checkStreamIntegrity) заново доставляет
  // недавние свечи через fetchHistory(...), НЕ отключая при этом живой
  // источник. Если для одной и той же уже закрытой свечи (тот же
  // candle.time, isClosed === true) эмиссия приходит из ДВУХ независимых
  // мест (обычный source.onCandle И resync()), downstream
  // (useTickStore.handleCandle) обрабатывал бы её закрытие дважды —
  // checkExpiries/maybeEvaluateSignal/maybeResolveOutcomes выполнялись бы
  // повторно для уже обработанного закрытия. connectionManager должен
  // гасить повторную эмиссию ЗАКРЫТИЯ одной и той же свечи независимо от
  // того, какой из двух путей доставки сработал вторым.
  it('does not emit the same closed candle twice even from two independent delivery paths', async () => {
    let capturedOnCandle: ((candle: Candle, isClosed: boolean) => void) | null = null;
    const okResult: ConnectResult = {
      candles: [mockCandle(0)],
      source: 'binance',
    };
    const source: DataSource = {
      id: 'binance',
      connect: () => Promise.resolve(okResult),
      disconnect: () => {},
      fetchHistory: () => Promise.resolve([mockCandle(0)]),
      fetchServerTime: () => Promise.resolve(Date.now()),
      onTick: () => () => {},
      onCandle: (cb) => {
        capturedOnCandle = cb;
        return () => { capturedOnCandle = null; };
      },
      onStatus: (cb) => { cb('live'); return () => {}; },
    };

    vi.doMock('@/data/factory', () => ({
      createSource: () => source,
    }));

    const { ConnectionManager } = await import('@/data/connection-manager');
    const mgr = new ConnectionManager();
    await mgr.connectAndGetHistory(cryptoSymbol, '15m');

    const received: boolean[] = [];
    mgr.onCandle((_candle, isClosed) => received.push(isClosed));

    expect(capturedOnCandle).not.toBeNull();
    // Simulate the closed candle being delivered twice for the same
    // candle.time — as would happen if the live stream and a resync() both
    // reported the close of the same candle. Using the initial history
    // candle's own time (0, matching prevCandleTime) avoids tripping
    // checkStreamIntegrity's unrelated gap-detection/resync path.
    capturedOnCandle!(mockCandle(0), true);
    capturedOnCandle!(mockCandle(0), true);

    expect(received.filter(Boolean)).toHaveLength(1);

    // A genuinely new (later) closed candle must still go through normally.
    capturedOnCandle!(mockCandle(900), true);
    expect(received.filter(Boolean)).toHaveLength(2);

    mgr.disconnect();
  });

  it('resets the duplicate-close guard across reconnects', async () => {
    let capturedOnCandle: ((candle: Candle, isClosed: boolean) => void) | null = null;
    const okResult: ConnectResult = { candles: [mockCandle(0)], source: 'binance' };
    const source: DataSource = {
      id: 'binance',
      connect: () => Promise.resolve(okResult),
      disconnect: () => {},
      fetchHistory: () => Promise.resolve([mockCandle(0)]),
      fetchServerTime: () => Promise.resolve(Date.now()),
      onTick: () => () => {},
      onCandle: (cb) => { capturedOnCandle = cb; return () => {}; },
      onStatus: (cb) => { cb('live'); return () => {}; },
    };

    vi.doMock('@/data/factory', () => ({
      createSource: () => source,
    }));

    const { ConnectionManager } = await import('@/data/connection-manager');
    const mgr = new ConnectionManager();
    await mgr.connectAndGetHistory(cryptoSymbol, '15m');

    const received: boolean[] = [];
    mgr.onCandle((_candle, isClosed) => received.push(isClosed));

    // candle.time === prevCandleTime (both 0, from the initial history
    // candle) so this does not trip checkStreamIntegrity's gap detection —
    // it's just the close of the same candle the session started with.
    capturedOnCandle!(mockCandle(0), true);
    expect(received.filter(Boolean)).toHaveLength(1);
    mgr.disconnect();

    // Reconnecting for a fresh session must not remember the prior close —
    // otherwise a legitimately new session replaying the same candle.time
    // (e.g. after a symbol switch and back) would be silently dropped.
    await mgr.connectAndGetHistory(cryptoSymbol, '15m');
    capturedOnCandle!(mockCandle(0), true);

    expect(received.filter(Boolean)).toHaveLength(2);
    mgr.disconnect();
  });
});

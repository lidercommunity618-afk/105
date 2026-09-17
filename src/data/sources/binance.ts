import type { Candle, Tick, Timeframe, ConnectionStatus, SourceId } from '@/types/domain';
import type { DataSource, ConnectResult } from '../source';
import { normalizeServerTime } from '../source';
import { PROVIDERS_CONFIG } from '../providers.config';

type StatusListener = (status: ConnectionStatus) => void;
type TickListener = (tick: Tick) => void;
type CandleListener = (candle: Candle, isClosed: boolean) => void;

function safeParseFloat(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v);
  return NaN;
}

export class BinanceSource implements DataSource {
  readonly id: SourceId = 'binance';

  private ws: WebSocket | null = null;
  private activeSymbol: string | null = null;
  private activeTimeframe: Timeframe | null = null;
  private statusListeners = new Set<StatusListener>();
  private tickListeners = new Set<TickListener>();
  private candleListeners = new Set<CandleListener>();
  private status: ConnectionStatus = 'idle';
  private reconnectCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectScheduled = false;

  async connect(symbolId: string, timeframe: Timeframe): Promise<ConnectResult> {
    const interval = PROVIDERS_CONFIG.binance.intervalMap[timeframe];
    if (!interval) throw new Error(`Binance: unsupported timeframe ${timeframe}`);

    this.disconnect();
    this.activeSymbol = symbolId;
    this.activeTimeframe = timeframe;
    this.reconnectCount = 0;
    this.setStatus('connecting');

    const candles = await this.fetchHistory(symbolId, timeframe, PROVIDERS_CONFIG.binance.defaultHistory);
    this.openSocket(symbolId, timeframe, PROVIDERS_CONFIG.binance.wsHosts.global);
    return { candles, source: this.id };
  }

  disconnect(): void {
    this.activeSymbol = null;
    this.activeTimeframe = null;
    this.reconnectScheduled = false;
    this.reconnectCount = 0;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    this.setStatus('idle');
  }

  async fetchHistory(symbolId: string, timeframe: Timeframe, count: number): Promise<Candle[]> {
    const interval = PROVIDERS_CONFIG.binance.intervalMap[timeframe];
    if (!interval) throw new Error(`Binance: unsupported timeframe ${timeframe}`);

    let lastErr: Error | null = null;
    for (const base of PROVIDERS_CONFIG.binance.restHosts) {
      try {
        return await this.fetchHistoryFrom(base, symbolId, interval, count);
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastErr ?? new Error('Binance: all REST endpoints failed');
  }

  private async fetchHistoryFrom(
    base: string,
    symbolId: string,
    interval: string,
    count: number,
  ): Promise<Candle[]> {
    const url = `${base}/api/v3/klines?symbol=${symbolId}&interval=${interval}&limit=${count}`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(PROVIDERS_CONFIG.binance.requestTimeoutMs) });
      if (!res.ok) throw new Error(`Binance history ${res.status}`);
      const raw = (await res.json()) as unknown;
      if (!Array.isArray(raw)) throw new Error('Binance history: unexpected shape');
      return raw.map((row) => parseKline(row));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error('Binance: request timeout');
      }
      if (err instanceof Error) throw err;
      throw new Error('Binance: fetch failed');
    }
  }

  async fetchServerTime(): Promise<number> {
    for (const base of PROVIDERS_CONFIG.binance.restHosts) {
      try {
        const res = await fetch(`${base}/api/v3/time`, { signal: AbortSignal.timeout(PROVIDERS_CONFIG.binance.requestTimeoutMs) });
        if (!res.ok) throw new Error(`Binance time ${res.status}`);
        const data = (await res.json()) as { serverTime: number };
        return normalizeServerTime(data.serverTime);
      } catch {
        // try next host
      }
    }
    return normalizeServerTime(Date.now());
  }

  onTick(cb: TickListener): () => void {
    this.tickListeners.add(cb);
    return () => this.tickListeners.delete(cb);
  }

  onCandle(cb: CandleListener): () => void {
    this.candleListeners.add(cb);
    return () => this.candleListeners.delete(cb);
  }

  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  private openSocket(symbolId: string, timeframe: Timeframe, wsUrl: string): void {
    const interval = PROVIDERS_CONFIG.binance.intervalMap[timeframe] ?? timeframe;
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
    }
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.setStatus('live');
      const klineSub = `${symbolId.toLowerCase()}@kline_${interval}`;
      const tickSub = `${symbolId.toLowerCase()}@miniTicker`;
      try {
        ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [klineSub, tickSub], id: 1 }));
      } catch {
        // socket closed between open and send
      }
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      this.handleMessage(e.data);
    };
    ws.onerror = () => this.setStatus('degraded');
    ws.onclose = () => {
      if (this.activeSymbol !== null && !this.reconnectScheduled) {
        this.scheduleReconnect();
      } else if (this.activeSymbol === null) {
        this.setStatus('idle');
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectScheduled) return;
    const maxReconnect = PROVIDERS_CONFIG.binance.reconnectBackoffMs.length;
    if (this.reconnectCount >= maxReconnect) {
      this.reconnectScheduled = false;
      this.setStatus('failed');
      return;
    }
    this.reconnectScheduled = true;
    const idx = Math.min(this.reconnectCount, PROVIDERS_CONFIG.binance.reconnectBackoffMs.length - 1);
    const delay = PROVIDERS_CONFIG.binance.reconnectBackoffMs[idx];
    this.reconnectCount++;
    this.setStatus('reconnecting');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectScheduled = false;
      if (this.activeSymbol && this.activeTimeframe) {
        const wsUrl = this.reconnectCount > 2 ? PROVIDERS_CONFIG.binance.wsHosts.us : PROVIDERS_CONFIG.binance.wsHosts.global;
        this.openSocket(this.activeSymbol, this.activeTimeframe, wsUrl);
      }
    }, delay);
  }

  private setStatus(s: ConnectionStatus): void {
    this.status = s;
    this.emitToListeners(this.statusListeners, s);
  }

  private handleMessage(raw: string): void {
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return; }
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, unknown>;
    if (msg.e === 'kline') {
      this.handleKline(msg);
    } else if (msg.e === '24hrMiniTicker') {
      this.handleMiniTicker(msg);
    }
  }

  private handleKline(msg: Record<string, unknown>): void {
    const k = msg.k as Record<string, unknown> | undefined;
    if (!k) return;
    const candle: Candle = {
      time: Math.floor(Number(k.t) / 1000),
      open: safeParseFloat(k.o),
      high: safeParseFloat(k.h),
      low: safeParseFloat(k.l),
      close: safeParseFloat(k.c),
      volume: safeParseFloat(k.v),
    };
    const isClosed = k.x === true;
    this.emitToListeners(this.candleListeners, candle, isClosed);
  }

  private handleMiniTicker(msg: Record<string, unknown>): void {
    const tick: Tick = {
      price: safeParseFloat(msg.c),
      time: Math.floor(Number(msg.E) / 1000),
    };
    this.emitToListeners(this.tickListeners, tick);
  }

  private emitToListeners<T extends (...args: never[]) => void>(
    listeners: Set<T>,
    ...args: Parameters<T>
  ): void {
    listeners.forEach((l) => {
      try { l(...args); } catch { /* isolate listener errors */ }
    });
  }
}

function parseKline(row: unknown): Candle {
  const r = row as (string | number)[];
  return {
    time: Math.floor(Number(r[0]) / 1000),
    open: safeParseFloat(r[1]),
    high: safeParseFloat(r[2]),
    low: safeParseFloat(r[3]),
    close: safeParseFloat(r[4]),
    volume: safeParseFloat(r[5]),
  };
}

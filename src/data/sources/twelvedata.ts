import type { Candle, Tick, Timeframe, ConnectionStatus, SourceId } from '@/types/domain';
import type { DataSource, ConnectResult } from '../source';
import { normalizeServerTime } from '../source';
import { serverClock } from '../server-clock';
import { getClientId } from '@/lib/client-id';
import { isSupabaseConfigured } from '@/lib/supabase';
import { TIMEFRAME_SECONDS, mapSymbolForSource } from '@/data/symbols';
import { PROVIDERS_CONFIG } from '../providers.config';

const PROXY_TIMEOUT_MS = 12_000;

const POLL_MS = 2500;

type StatusListener = (status: ConnectionStatus) => void;
type TickListener = (tick: Tick) => void;
type CandleListener = (candle: Candle, isClosed: boolean) => void;

export class TwelveDataSource implements DataSource {
  readonly id: SourceId = 'twelvedata';

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeSymbol: string | null = null;
  private activeTimeframe: Timeframe | null = null;
  private lastCandleTime = 0;
  private statusListeners = new Set<StatusListener>();
  private tickListeners = new Set<TickListener>();
  private candleListeners = new Set<CandleListener>();
  private status: ConnectionStatus = 'idle';

  private getProxyUrl(): string {
    const url = import.meta.env.VITE_SUPABASE_URL;
    if (!url) throw new Error('TwelveData: Supabase URL not configured');
    return `${url}/functions/v1/proxy-twelvedata`;
  }

  private getAnonKey(): string {
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (!key) throw new Error('TwelveData: Supabase anon key not configured');
    return key;
  }

  async connect(symbolId: string, timeframe: Timeframe): Promise<ConnectResult> {
    this.disconnect();
    this.activeSymbol = symbolId;
    this.activeTimeframe = timeframe;
    this.setStatus('connecting');
    const candles = await this.fetchHistory(symbolId, timeframe, PROVIDERS_CONFIG.twelvedata.defaultHistory);
    if (candles.length > 0) this.lastCandleTime = candles[candles.length - 1].time;
    this.startPolling(symbolId, timeframe);
    this.setStatus('live');
    return { candles, source: this.id };
  }

  disconnect(): void {
    this.activeSymbol = null;
    this.activeTimeframe = null;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.setStatus('idle');
  }

  async fetchHistory(symbolId: string, timeframe: Timeframe, count: number): Promise<Candle[]> {
    const interval = PROVIDERS_CONFIG.twelvedata.intervalMap[timeframe];
    if (!interval) throw new Error(`TwelveData: unsupported timeframe ${timeframe}`);
    if (!isSupabaseConfigured) throw new Error('TwelveData: Supabase not configured — proxy required');
    const url = this.getProxyUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.getAnonKey()}`,
          'X-Client-Key': getClientId(),
        },
        body: JSON.stringify({ symbol: mapSymbolForSource(symbolId, 'twelvedata'), timeframe, outputsize: count }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === 'AbortError') throw new Error('TwelveData: request timeout');
      throw err;
    }
    clearTimeout(timer);
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      const msg = typeof errBody.error === 'string' ? errBody.error : `HTTP ${res.status}`;
      throw new Error(`TwelveData: ${msg}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    if (data.status === 'error') {
      const msg = data.message;
      throw new Error(`TwelveData: ${typeof msg === 'string' ? msg : 'error'}`);
    }
    if (data.code === 429) throw new Error('TwelveData: rate limit exceeded');
    const values = data.values as Array<Record<string, string>> | undefined;
    if (!Array.isArray(values)) throw new Error('TwelveData: unexpected shape');
    return values.reverse().map((v) => {
      const t = new Date(v.datetime).getTime();
      if (Number.isNaN(t)) throw new Error('TwelveData: invalid datetime in response');
      return {
        time: Math.floor(t / 1000),
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        volume: parseFloat(v.volume ?? '0'),
      };
    });
  }

  async fetchServerTime(): Promise<number> {
    // TwelveData /time endpoint does not need an API key — safe to call directly.
    const res = await fetch(`${PROVIDERS_CONFIG.twelvedata.restUrl.replace('/time_series', '/time')}?format=UNIX`);
    if (!res.ok) throw new Error(`TwelveData time ${res.status}`);
    const data = (await res.json()) as { timestamp: number };
    return normalizeServerTime(data.timestamp);
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

  private startPolling(symbolId: string, timeframe: Timeframe): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      void this.poll(symbolId, timeframe).catch(() => this.setStatus('degraded'));
    }, POLL_MS);
  }

  private async poll(symbolId: string, timeframe: Timeframe): Promise<void> {
    const tfSec = TIMEFRAME_SECONDS[timeframe];
    const candles = await this.fetchHistory(symbolId, timeframe, 2);
    const now = Math.floor(serverClock.now() / 1000);
    for (const c of candles) {
      if (c.time < this.lastCandleTime) continue;
      this.lastCandleTime = c.time;
      const isClosed = now >= c.time + tfSec;
      this.emit(this.candleListeners, c, isClosed);
    }
    const last = candles[candles.length - 1];
    if (last) {
      this.emit(this.tickListeners, { price: last.close, time: last.time } satisfies Tick);
    }
    this.setStatus('live');
  }

  private setStatus(s: ConnectionStatus): void {
    this.status = s;
    this.emit(this.statusListeners, s);
  }

  private emit<T extends (...args: never[]) => void>(listeners: Set<T>, ...args: Parameters<T>): void {
    listeners.forEach((l) => { try { l(...args); } catch { /* isolate */ } });
  }
}

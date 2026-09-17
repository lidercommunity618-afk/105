import type { Candle } from '@/types/domain';
import { isCrypto, isDerivSupported, mapSymbolForDeriv } from '@/data/symbols';

const BINANCE_REST = 'https://api.binance.com';
const DERIV_WS = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
// Deriv ticks_history accepts count up to 5000 — 5× more data per request
// than the previous 1000. Verified: the API does not silently truncate.
const MAX_PER_REQUEST = 5000;
const BINANCE_MAX_PER_REQUEST = 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const DERIV_GRANULARITY = 60;
const MAX_DERIV_ITERATIONS = 200;

export interface LoadOptions {
  symbol: string;
  fromMs: number;
  toMs: number;
}

export async function loadHistory(options: LoadOptions): Promise<Candle[]> {
  const { symbol } = options;
  if (isDerivSupported(symbol)) {
    return loadDerivHistory(options);
  }
  if (isCrypto(symbol)) {
    return loadBinanceHistory(options);
  }
  return loadDerivHistory(options);
}

async function loadBinanceHistory(options: LoadOptions): Promise<Candle[]> {
  const { symbol, fromMs, toMs } = options;
  const candles: Candle[] = [];
  let startTime = fromMs;

  while (startTime < toMs) {
    const batch = await fetchBinanceBatch(symbol, startTime, toMs);
    if (batch.length === 0) break;

    for (const c of batch) {
      if (c.time * 1000 <= toMs) candles.push(c);
    }

    if (batch.length < BINANCE_MAX_PER_REQUEST) break;
    startTime = batch[batch.length - 1].time * 1000 + 60_000;
  }

  return deduplicate(candles);
}

async function fetchBinanceBatch(symbol: string, startTime: number, endTime: number): Promise<Candle[]> {
  const url =
    `${BINANCE_REST}/api/v3/klines?symbol=${symbol}&interval=1m` +
    `&startTime=${startTime}&endTime=${endTime}&limit=${BINANCE_MAX_PER_REQUEST}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Binance API ${res.status} ${res.statusText}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('Binance API: unexpected response shape');
    return rows.map(parseKlineRow);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Binance API: request timeout');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function parseKlineRow(row: unknown): Candle {
  const r = row as (string | number)[];
  return {
    time: Math.floor(Number(r[0]) / 1000),
    open: parseFloat(String(r[1])),
    high: parseFloat(String(r[2])),
    low: parseFloat(String(r[3])),
    close: parseFloat(String(r[4])),
    volume: parseFloat(String(r[5])),
  };
}

async function loadDerivHistory(options: LoadOptions): Promise<Candle[]> {
  const { symbol, fromMs, toMs } = options;
  const allCandles: Candle[] = [];
  let endTime = Math.floor(toMs / 1000);
  const startSec = Math.floor(fromMs / 1000);
  let iterations = 0;
  let prevEndTime = endTime + 1;

  while (endTime > startSec && iterations < MAX_DERIV_ITERATIONS) {
    iterations++;
    const batch = await fetchDerivBatch(symbol, endTime);
    if (batch.length === 0) {
      console.log(`  [Deriv] stopping: empty batch at iteration ${iterations}`);
      break;
    }

    const oldest = batch[0].time;
    for (const c of batch) {
      if (c.time >= startSec && c.time <= endTime) allCandles.push(c);
    }

    if (oldest <= startSec) {
      console.log(`  [Deriv] stopping: reached start boundary at iteration ${iterations} (oldest=${oldest}, start=${startSec})`);
      break;
    }

    // No-progress guard: if oldest didn't move backward, we'd loop forever
    if (oldest >= prevEndTime) {
      console.log(`  [Deriv] stopping: no progress at iteration ${iterations} (oldest=${oldest} >= prevEndTime=${prevEndTime})`);
      break;
    }

    // Do NOT break on short batch — forex weekend gaps produce partial batches
    // mid-history. Only batch.length === 0 means we've exhausted the API.
    prevEndTime = endTime;
    endTime = oldest - 1;
  }

  if (iterations >= MAX_DERIV_ITERATIONS) {
    console.log(`  [Deriv] stopping: hit iteration cap (${MAX_DERIV_ITERATIONS})`);
  }

  console.log(`  [Deriv] finished after ${iterations} iterations, ${allCandles.length} candles`);
  return deduplicate(allCandles);
}

interface DerivPending {
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

async function fetchDerivBatch(symbol: string, endEpoch: number): Promise<Candle[]> {
  const derivSymbol = mapSymbolForDeriv(symbol);
  return new Promise<Candle[]>((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS);
    const pending = new Map<number, DerivPending>();
    let settled = false;

    const cleanup = () => {
      pending.forEach((p) => { clearTimeout(p.timer); });
      pending.clear();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Deriv WS: request timeout'));
    }, REQUEST_TIMEOUT_MS);

    ws.onopen = () => {
      const reqId = 1;
      pending.set(reqId, {
        resolve: (data) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const candlesRaw = data.candles as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(candlesRaw)) {
            reject(new Error('Deriv: unexpected history shape'));
            return;
          }
          const candles = candlesRaw.map((c) => ({
            time: Number(c.epoch),
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
            volume: 0,
          }));
          resolve(candles);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });
      ws.send(JSON.stringify({
        ticks_history: derivSymbol,
        end: String(endEpoch),
        style: 'candles',
        granularity: DERIV_GRANULARITY,
        count: MAX_PER_REQUEST,
        req_id: 1,
      }));
    };

    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let data: unknown;
      try { data = JSON.parse(e.data); } catch { return; }
      if (!data || typeof data !== 'object') return;
      const msg = data as Record<string, unknown>;
      const reqId = typeof msg.req_id === 'number' ? msg.req_id : (typeof msg.req_id === 'string' ? Number(msg.req_id) : undefined);
      if (reqId && pending.has(reqId)) {
        const p = pending.get(reqId)!;
        pending.delete(reqId);
        if (msg.error) {
          p.reject(new Error(String((msg.error as Record<string, unknown>).message ?? 'Deriv error')));
        } else {
          p.resolve(msg);
        }
      }
    };

    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Deriv WS: connection failed'));
    };

    ws.onclose = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('Deriv WS: connection closed unexpectedly'));
      }
    };
  });
}

function deduplicate(candles: Candle[]): Candle[] {
  const seen = new Set<number>();
  const result: Candle[] = [];
  for (const c of candles) {
    if (!seen.has(c.time)) {
      seen.add(c.time);
      result.push(c);
    }
  }
  return result.sort((a, b) => a.time - b.time);
}

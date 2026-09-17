import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../server-clock', () => ({
  serverClock: { now: () => Date.now() },
}));

vi.mock('../providers.config', () => ({
  buildDerivWsUrl: () => 'wss://mock.deriv.com?app_id=test',
  PROVIDERS_CONFIG: {
    deriv: {
      wsUrl: 'wss://mock.deriv.com',
      appId: 'test',
      granularityMap: { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 },
      reconnectBackoffMs: [3000, 6000, 12000, 30000, 60000],
      pingIntervalMs: 15000,
      requestTimeoutMs: 10000,
      defaultHistory: 1000,
    },
  },
}));

vi.mock('../symbols', () => ({
  mapSymbolForDeriv: (s: string) => s,
}));

vi.mock('@/lib/sentry', () => ({
  captureError: vi.fn(),
}));

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static last(): MockWebSocket { return MockWebSocket.instances[MockWebSocket.instances.length - 1]; }

  // Реальный global.WebSocket.OPEN/.CONNECTING и т.д. — эти статики нужны,
  // потому что производственный код сравнивает readyState именно с
  // `WebSocket.OPEN` (глобальным), а не с числом-литералом. Без них любое
  // сравнение с undefined всегда ложно, и send()/subscribeStreams() тихо
  // не отправляют ничего даже при открытом соединении — раньше это было
  // незаметно, потому что fetchHistory в тестах мокался целиком и не
  // проходил через реальный send().
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, cb: (...args: never[]) => void) {
    if (event === 'open') this.onopen = cb;
    if (event === 'error') this.onerror = cb;
    if (event === 'close') this.onclose = cb;
  }

  removeEventListener() {}

  send(data: string) { this.sent.push(data); }

  close() { this.readyState = 3; this.onclose?.(); }

  fireOpen() { this.readyState = 1; this.onopen?.(); }

  fireMessage(obj: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

global.WebSocket = MockWebSocket as unknown as typeof WebSocket;

import { DerivSource } from './deriv';

describe('DerivSource fallback polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function flushMicrotasks(times = 10): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve();
  }

  it('invokes fetchHistory via fallback polling once the stream goes stale', async () => {
    const source = new DerivSource();
    const fetchSpy = vi.spyOn(source, 'fetchHistory').mockResolvedValue([
      { time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 },
    ]);

    const connectPromise = source.connect('R_100', '1m');
    const ws = MockWebSocket.last();
    ws.fireOpen();

    // Резолвим subscribeStreams (ticks-subscribe req_id 1, ohlc-subscribe
    // req_id 2) — с реальными WebSocket.OPEN-константами в моке send()
    // теперь действительно уходит в сокет и ждёт ответа, поэтому оба
    // запроса нужно закрыть, иначе connect() зависнет на requestTimeoutMs.
    await flushMicrotasks();
    ws.fireMessage({ req_id: 1 });
    await flushMicrotasks();
    ws.fireMessage({ req_id: 2 });
    await flushMicrotasks();

    await connectPromise;

    const initialCalls = fetchSpy.mock.calls.length;

    // Стрим не присылает ничего дальше — становится stale, watchdog-polling
    // должен взять на себя роль основного источника.
    vi.advanceTimersByTime(10_000);

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(initialCalls);

    source.disconnect();
  });

  it('does not poll while the WS stream is healthy (recent tick/ohlc message received)', async () => {
    // Регрессионный тест на фикс "polling как watchdog, а не постоянный
    // параллельный поток": если стрим реально жив (успешная подписка +
    // недавнее сообщение), poll() не должен вызываться на каждом тике
    // таймера — иначе WS и REST гоняются за одной и той же формирующейся
    // свечой, и REST может перезаписать более свежие/широкие high/low.
    const source = new DerivSource();
    const fetchSpy = vi.spyOn(source, 'fetchHistory').mockResolvedValue([
      { time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 },
    ]);

    const connectPromise = source.connect('R_100', '1m');
    const ws = MockWebSocket.last();
    ws.fireOpen();

    // Резолвим все pending req_id по очереди: fetchHistory замокан
    // напрямую (не идёт через send()), поэтому единственные реальные
    // send()-запросы — это subscribeStreams (ticks subscribe, ohlc
    // subscribe). Отвечаем на оба, чтобы подписка считалась успешной.
    // flushMicrotasks нужен, потому что между fireOpen и фактическим
    // ws.send() внутри subscribeStreams лежит несколько промежуточных
    // await (ensureSocket, мокнутый fetchHistory) — одного tick очереди
    // микрозадач недостаточно, чтобы до них добраться.
    await flushMicrotasks();
    ws.fireMessage({ req_id: 1 });
    await flushMicrotasks();
    ws.fireMessage({ req_id: 2 });
    await flushMicrotasks();

    await connectPromise;

    const initialCalls = fetchSpy.mock.calls.length;

    // Стрим шлёт ohlc-апдейты регулярно, чаще, чем таймер fallback-poll
    // (3с для '1m') — держим его "свежим" на каждом тике таймера, как
    // вело бы себя реальное живое соединение.
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(1_000);
      ws.fireMessage({ ohlc: { open_time: 100, open: 1, high: 2, low: 0.5, close: 1.6 } });
    }

    // За 8 секунд поллинг-таймер (интервал 3с) успел бы тикнуть дважды-трижды,
    // но т.к. стрим все это время оставался "свежим" (heartbeat каждую
    // секунду < intervalMs*2 = 6с), poll ни разу реально не вызвался.
    expect(fetchSpy.mock.calls.length).toBe(initialCalls); // poll не вызвался — стрим здоров

    source.disconnect();
  });

  it('resumes polling once the stream goes stale (no messages for a while)', async () => {
    const source = new DerivSource();
    const fetchSpy = vi.spyOn(source, 'fetchHistory').mockResolvedValue([
      { time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 },
    ]);

    const connectPromise = source.connect('R_100', '1m');
    const ws = MockWebSocket.last();
    ws.fireOpen();
    await flushMicrotasks();
    ws.fireMessage({ req_id: 1 });
    await flushMicrotasks();
    ws.fireMessage({ req_id: 2 });
    await flushMicrotasks();
    await connectPromise;

    const initialCalls = fetchSpy.mock.calls.length;

    // Стрим "замолкает" дольше 2×intervalMs (2×3000мс для '1m') без новых
    // сообщений — polling должен снова взять на себя роль основного
    // источника.
    vi.advanceTimersByTime(9_000);

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(initialCalls);

    source.disconnect();
  });
});

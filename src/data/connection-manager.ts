import type { Candle, Tick, Timeframe, ConnectionStatus, SourceId, Symbol } from '@/types/domain';
import type { DataSource } from './source';
import { createSource } from './factory';
import { serverClock } from './server-clock';
import { captureError } from '@/lib/sentry';
import { TIMEFRAME_SECONDS, getRoutingChain } from './symbols';
import { STALE_TICK_MS } from './providers.config';
import { isMarketOpen } from './market-hours';

const BACKOFF_MS = [1000, 2000, 4000];
const MAX_ATTEMPTS_PER_SOURCE = 3;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

type StatusListener = (status: ConnectionStatus) => void;
type TickListener = (tick: Tick) => void;
type CandleListener = (candle: Candle, isClosed: boolean) => void;

// Наружное уведомление о том, какой источник сейчас пробуется в цепочке
// getRoutingChain, и провалился ли предыдущий — используется UI (StatusBar),
// чтобы показать «Binance недоступен, переключаемся на Deriv…» вместо тишины
// до финального успеха/провала. Сама цепочка/ретраи/backoff не меняются —
// это только видимость уже существующего поведения.
export interface SourceAttemptEvent {
  sourceId: SourceId;
  isFallback: boolean;
  previousSourceId: SourceId | null;
}
type SourceAttemptListener = (event: SourceAttemptEvent) => void;

export interface ConnectAndHistory {
  status: ConnectionStatus;
  candles: Candle[];
  source: SourceId;
}

export class ConnectionManager {
  private source: DataSource | null = null;
  private sourceUnsubs: (() => void)[] = [];
  private activeSourceId: SourceId | null = null;
  private activeSymbol: Symbol | null = null;
  private activeTimeframe: Timeframe | null = null;
  private prevCandleTime: number | null = null;
  // Аудит (синхронизация/двойная обработка): resync() ниже НЕ отключает и
  // не приостанавливает живой источник (this.source) на время своего
  // await fetchHistory(...) — оба пути (обычный source.onCandle из
  // attachSource() и повторная доставка через resync()) остаются
  // одновременно подписаны на candleListeners. Если resync() вызван из-за
  // обнаруженного разрыва потока (checkStreamIntegrity), а сам живой
  // источник в этот момент уже прислал (или присылает конкурентно) ЗАКРЫТИЕ
  // той же свечи, то ОДНА и та же закрытая свеча (тот же candle.time,
  // isClosed === true) уходит слушателям (в конечном счёте — в
  // useTickStore.handleCandle) ДВАЖДЫ из двух независимых источников
  // эмиссии. В отличие от перехода на НОВУЮ свечу (там есть guard
  // `lastCandleCloseAtMs !== prevCloseMs` в useTickStore), нижний блок
  // `if (isClosed)` в handleCandle отрабатывает безусловно на каждый такой
  // вызов — checkExpiries/maybeEvaluateSignal/maybeResolveOutcomes
  // выполняются повторно для уже обработанного закрытия свечи. Большая
  // часть даунстрим-эффектов дедуплицирована по signal.id/trade.signalId,
  // но сам факт двух эмиссий одного и того же закрытия — реальный источник
  // гонки/лишней нагрузки, который стоит пресечь на уровне транспорта, а не
  // полагаться исключительно на даунстрим-дедуп. lastClosedEmitTime не
  // персистентен и сбрасывается на каждый (пере)коннект — см. disconnect().
  private lastClosedEmitTime: number | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;
  private statusListeners = new Set<StatusListener>();
  private tickListeners = new Set<TickListener>();
  private candleListeners = new Set<CandleListener>();
  private sourceAttemptListeners = new Set<SourceAttemptListener>();
  private status: ConnectionStatus = 'idle';
  private connectSeq = 0;

  get activeSource(): SourceId | null {
    return this.activeSourceId;
  }

  get currentStatus(): ConnectionStatus {
    return this.status;
  }

  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  onTick(cb: TickListener): () => void {
    this.tickListeners.add(cb);
    return () => this.tickListeners.delete(cb);
  }

  onCandle(cb: CandleListener): () => void {
    this.candleListeners.add(cb);
    return () => this.candleListeners.delete(cb);
  }

  onSourceAttempt(cb: SourceAttemptListener): () => void {
    this.sourceAttemptListeners.add(cb);
    return () => this.sourceAttemptListeners.delete(cb);
  }

  async connectAndGetHistory(symbol: Symbol, timeframe: Timeframe): Promise<ConnectAndHistory> {
    const seq = ++this.connectSeq;
    this.disconnect();
    this.activeSymbol = symbol;
    this.activeTimeframe = timeframe;
    this.prevCandleTime = null;
    this.setStatus('connecting');

    const chain = getRoutingChain(symbol);
    let previousSourceId: SourceId | null = null;
    for (const sourceId of chain) {
      if (seq !== this.connectSeq) return { status: 'idle', candles: [], source: sourceId };
      this.emit(this.sourceAttemptListeners, { sourceId, isFallback: previousSourceId !== null, previousSourceId });
      const result = await this.trySource(sourceId, symbol.id, timeframe, seq);
      if (result) return result;
      previousSourceId = sourceId;
    }
    this.setStatus('failed');
    return { status: 'failed', candles: [], source: chain[0] };
  }

  private async trySource(
    sourceId: SourceId,
    symbolId: string,
    timeframe: Timeframe,
    seq: number,
  ): Promise<ConnectAndHistory | null> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_SOURCE; attempt++) {
      if (seq !== this.connectSeq) return null;
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      if (attempt > 0) await sleep(delay);
      if (seq !== this.connectSeq) return null;
      try {
        const source = createSource(sourceId);
        const { candles, source: connectedId } = await source.connect(symbolId, timeframe);
        if (seq !== this.connectSeq) {
          source.disconnect();
          return null;
        }
        this.source = source;
        this.activeSourceId = connectedId;
        if (candles.length > 0) {
          this.prevCandleTime = candles[candles.length - 1].time;
        }
        this.attachSource(source);
        this.setStatus('live');
        this.lastTickAt = Date.now();
        void this.syncServerTime();
        this.startPeriodicSync();
        this.startStaleWatchdog();
        return { status: 'live', candles, source: connectedId };
      } catch (err) {
        this.setStatus('reconnecting');
        captureError(new Error(`Source ${sourceId} attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : 'unknown'}`), { level: 'warning' });
      }
    }
    return null;
  }

  // Единая точка эмиссии свечи слушателям — как для обычного живого потока
  // (attachSource), так и для повторной доставки при resync(). Гасит
  // ДУБЛИРУЮЩУЮ эмиссию закрытия одной и той же свечи (см. комментарий у
  // lastClosedEmitTime) — если candle.time с isClosed === true уже был
  // отправлен слушателям, повторный вызов с тем же (закрытым) candle.time
  // отбрасывается независимо от того, из какого из двух источников он
  // пришёл. Обновления ЕЩЁ ФОРМИРУЮЩЕЙСЯ свечи (isClosed === false) не
  // ограничиваются — это обычный, частый и безопасный для дедупа поток.
  private emitCandleEvent(candle: Candle, isClosed: boolean): void {
    if (isClosed) {
      if (this.lastClosedEmitTime === candle.time) return;
      this.lastClosedEmitTime = candle.time;
    }
    this.emit(this.candleListeners, candle, isClosed);
  }

  private attachSource(source: DataSource): void {
    this.sourceUnsubs.push(
      source.onCandle((candle, isClosed) => {
        this.checkStreamIntegrity(candle);
        this.emitCandleEvent(candle, isClosed);
      }),
    );
    this.sourceUnsubs.push(
      source.onTick((tick) => {
        this.lastTickAt = Date.now();
        this.emit(this.tickListeners, tick);
      }),
    );
    this.sourceUnsubs.push(
      source.onStatus((s) => {
        if (s === 'idle') return;
        this.setStatus(s);
      }),
    );
  }

  private checkStreamIntegrity(candle: Candle): void {
    if (this.prevCandleTime !== null && this.activeTimeframe !== null) {
      const expectedOpen = this.prevCandleTime + TIMEFRAME_SECONDS[this.activeTimeframe];
      if (candle.time !== expectedOpen && candle.time !== this.prevCandleTime) {
        captureError(new Error(`Stream gap: expected open ${expectedOpen}, got ${candle.time} (prev ${this.prevCandleTime})`), { level: 'warning' });
        void this.resync();
      }
    }
    this.prevCandleTime = candle.time;
  }

  private async resync(): Promise<void> {
    if (!this.activeSymbol || !this.activeTimeframe || !this.source) return;
    try {
      const fresh = await this.source.fetchHistory(this.activeSymbol.id, this.activeTimeframe, 50);
      const seen = new Set<number>();
      const tfSec = TIMEFRAME_SECONDS[this.activeTimeframe];
      const serverNowSec = Math.floor(serverClock.now() / 1000);
      for (const c of fresh) {
        if (seen.has(c.time)) continue;
        seen.add(c.time);
        this.checkStreamIntegrity(c);
        const isClosed = serverNowSec >= c.time + tfSec;
        this.emitCandleEvent(c, isClosed);
      }
    } catch {
      this.setStatus('degraded');
    }
  }

  private async syncServerTime(): Promise<void> {
    if (!this.source) return;
    try {
      const serverTime = await this.source.fetchServerTime();
      if (!this.source) return;
      serverClock.sync(serverTime);
    } catch {
      // keep using last known offset
    }
  }

  private startPeriodicSync(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = setInterval(() => void this.syncServerTime(), SYNC_INTERVAL_MS);
  }

  private startStaleWatchdog(): void {
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.lastTickAt = Date.now();
    this.staleTimer = setInterval(() => {
      if (this.status !== 'live') return;
      if (this.activeSymbol && !isMarketOpen(this.activeSymbol)) return;
      if (Date.now() - this.lastTickAt > STALE_TICK_MS) {
        captureError(new Error('Stale tick watchdog: no tick in 45s, forcing reconnect'), { level: 'warning' });
        void this.forceReconnect();
      }
    }, 15_000);
  }

  private async forceReconnect(): Promise<void> {
    if (!this.activeSymbol || !this.activeTimeframe) return;
    const seq = this.connectSeq;
    this.setStatus('reconnecting');
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
    if (this.staleTimer) { clearInterval(this.staleTimer); this.staleTimer = null; }
    this.sourceUnsubs.forEach((unsub) => { try { unsub(); } catch { /* isolate */ } });
    this.sourceUnsubs = [];
    if (this.source) { this.source.disconnect(); this.source = null; }
    this.lastTickAt = Date.now();
    const chain = getRoutingChain(this.activeSymbol);
    let previousSourceId: SourceId | null = null;
    for (const sourceId of chain) {
      if (seq !== this.connectSeq) return;
      this.emit(this.sourceAttemptListeners, { sourceId, isFallback: previousSourceId !== null, previousSourceId });
      const result = await this.trySource(sourceId, this.activeSymbol.id, this.activeTimeframe, seq);
      if (seq !== this.connectSeq) return;
      if (result) return;
      previousSourceId = sourceId;
    }
    this.setStatus('failed');
  }

  private setStatus(s: ConnectionStatus): void {
    this.status = s;
    this.emit(this.statusListeners, s);
  }

  private emit<T extends (...args: never[]) => void>(listeners: Set<T>, ...args: Parameters<T>): void {
    listeners.forEach((l) => {
      try {
        l(...args);
      } catch (err) {
        // Изолируем сбой одного слушателя от остальных, но больше не проглатываем ошибку молча —
        // необработанное исключение здесь (например, внутри handleCandle → checkExpiries/openTrade)
        // раньше исчезало без единого сообщения в консоли, из-за чего демо-счёт мог навсегда
        // замереть на закрытии свечей, хотя тики продолжали приходить как обычно.
        captureError(err, { context: 'connectionManager.emit' });
      }
    });
  }

  disconnect(): void {
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
    if (this.staleTimer) { clearInterval(this.staleTimer); this.staleTimer = null; }
    this.lastTickAt = 0;
    this.sourceUnsubs.forEach((unsub) => { try { unsub(); } catch { /* isolate */ } });
    this.sourceUnsubs = [];
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    this.activeSourceId = null;
    this.activeSymbol = null;
    this.activeTimeframe = null;
    this.prevCandleTime = null;
    this.lastClosedEmitTime = null;
    this.setStatus('idle');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const connectionManager = new ConnectionManager();

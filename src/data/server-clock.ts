export interface ServerClockListener {
  (serverTimeMs: number): void;
}

const DRIFT_TOLERANCE_MS = 250;
const TICK_INTERVAL_MS = 1000;

export class ServerClock {
  private offsetMs = 0;
  private lastSyncAt = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<ServerClockListener>();

  constructor() {
    this.tickTimer = setInterval(() => this.emit(), TICK_INTERVAL_MS);
  }

  now(): number {
    return Date.now() + this.offsetMs;
  }

  getOffset(): number {
    return this.offsetMs;
  }

  get lastSync(): number {
    return this.lastSyncAt;
  }

  sync(serverTimeMs: number): void {
    const now = Date.now();
    const newOffset = serverTimeMs - now;
    if (this.lastSyncAt > 0 && Math.abs(newOffset - this.offsetMs) <= DRIFT_TOLERANCE_MS) {
      this.offsetMs = Math.round(this.offsetMs * 0.8 + newOffset * 0.2);
    } else {
      this.offsetMs = newOffset;
    }
    this.lastSyncAt = now;
  }

  onTick(listener: ServerClockListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const t = this.now();
    this.listeners.forEach((l) => { try { l(t); } catch { /* isolate */ } });
  }
}

export const serverClock = new ServerClock();

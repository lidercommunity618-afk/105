import type { Candle, Signal, SignalOutcome } from '@/types/domain';

export interface ResolvedOutcome {
  signalId: string;
  outcome: SignalOutcome;
}

// Аудит (синхронизация с демо-счётом): раньше здесь проверялось касание
// уровней стопа/цели на протяжении до signal.barsToResolve (5) будущих
// свечей — совершенно другая модель, чем реальная демо-сделка
// (useDemoAccountStore.ts::resolveTrade), которая просто сравнивает цену
// закрытия РОВНО следующей свечи со входом (фиксированная выплата,
// никакого stopLoss/takeProfit). Эти две модели давали разные исходы для
// одного и того же signal.id — то самое расхождение "Последние сделки" vs
// "История сигналов"/винрейт, которое чинит этот аудит.
//
// Теперь resolveOutcome считает исход РОВНО так же, как resolveTrade():
// цена закрытия свечи, на которой истекает expiryBars, против
// signal.entryPrice. signal.stopLoss/signal.takeProfit больше не
// существуют в принципе (Фаза 1, "честный бинарный опцион" — удалены
// вместе с decision/trade-levels.ts), signal.barsToResolve — отдельный
// параметр окна анти-дублирования (signal-cooldown.ts), к резолву исхода
// отношения не имеет.
//
// BUGFIX (Фаза 0, "экспирация на карточке не совпадает с фактическим
// резолвом"): раньше здесь было жёстко захардкожено candlesAfterSignal[0]
// (ровно 1 бар) вне зависимости от того, что показывала карточка как
// "Экспир." (signal.recommendedExpiry могла быть 2-3 бара). Теперь резолв
// свечи выбирается по signal.expiryBars — тому же числу, которое
// signal-builder.ts вычислил из recommendedExpiry и положил в Signal.
// undefined (записи до фикса) трактуется как 1 бар — см. комментарий у
// Signal.expiryBars в types/domain.ts.
export function resolveOutcome(
  signal: Signal,
  candlesAfterSignal: Candle[],
): ResolvedOutcome | null {
  if (signal.outcome !== 'pending') return null;
  const expiryBars = signal.expiryBars ?? 1;
  if (candlesAfterSignal.length < expiryBars) return null;

  const expiryCandle = candlesAfterSignal[expiryBars - 1];
  const isBuy = signal.direction === 'buy';
  const isWin = isBuy
    ? expiryCandle.close > signal.entryPrice
    : expiryCandle.close < signal.entryPrice;
  const isTie = expiryCandle.close === signal.entryPrice;

  return {
    signalId: signal.id,
    outcome: isTie ? 'timeout' : isWin ? 'win' : 'loss',
  };
}

export function getCandlesAfterSignal(
  allCandles: Candle[],
  signalTime: number,
): Candle[] {
  const after: Candle[] = [];
  for (const c of allCandles) {
    if (c.time > signalTime) after.push(c);
  }
  return after;
}

export interface PendingSignal {
  signal: Signal;
  barsElapsed: number;
}

export class OutcomeScheduler {
  private pending: PendingSignal[] = [];

  schedule(signal: Signal): void {
    if (signal.outcome !== 'pending') return;
    // Дедуп по id: schedule() реально вызывается для одного и того же
    // сигнала (один и тот же candleTime → один и тот же id, см.
    // generateSignalId) из двух разных мест — pre-close (maybeTriggerPreClose)
    // и "подстраховки" в maybeEvaluateSignal при isClosed === true — это
    // осознанный fallback-путь (см. комментарий в useTickStore.ts).
    // Без этой проверки оба вызова кладут в `pending` ДВЕ отдельные записи
    // с одинаковым signal.id; когда исход наступает, onCandleClosed()
    // резолвит и вызывает onResolve() ОБА раза для одного и того же
    // сигнала — это удваивает обучающие сэмплы калибровки
    // (eng.recordOutcome/triggerRetrain) и лишние обновления БД, реально
    // искажая ту самую статистику, на которую жалуется пользователь.
    //
    // ВАЖНО: если сигнал уже в очереди, ОБНОВЛЯЕМ его, а не пропускаем —
    // pre-close мог положить tradeOpened: false (сделка не открылась из-за
    // guard'а "одна сделка на инструмент"), а позже, при реальном закрытии
    // свечи, maybeEvaluateSignal открывает сделку и вызывает schedule() с
    // tradeOpened: true. Без обновления в очереди остаётся устаревший
    // tradeOpened: false, и maybeResolveOutcomes позже перезапишет
    // корректный исход от useDemoAccountStore своим собственным
    // (неправильным) — рассинхрон "Последние сделки" vs "История сигналов".
    const existingIdx = this.pending.findIndex((p) => p.signal.id === signal.id);
    if (existingIdx >= 0) {
      this.pending[existingIdx] = { signal, barsElapsed: this.pending[existingIdx].barsElapsed };
      return;
    }
    this.pending.push({ signal, barsElapsed: 0 });
  }

  onCandleClosed(
    allCandles: Candle[],
    onResolve: (resolved: ResolvedOutcome, signal: Signal) => void,
  ): void {
    if (this.pending.length === 0) return;
    const stillPending: PendingSignal[] = [];

    for (const p of this.pending) {
      const candlesAfter = getCandlesAfterSignal(allCandles, p.signal.time);
      const resolved = resolveOutcome(p.signal, candlesAfter);
      if (resolved) {
        onResolve(resolved, p.signal);
      } else {
        stillPending.push({ ...p, barsElapsed: candlesAfter.length });
      }
    }

    this.pending = stillPending;
  }

  clear(): void {
    this.pending = [];
  }

  getPendingCount(): number {
    return this.pending.length;
  }

  getPendingList(): PendingSignal[] {
    return this.pending;
  }
}

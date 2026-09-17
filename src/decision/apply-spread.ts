import type { Signal, SignalOutcome } from '@/types/domain';

export interface SpreadAdjustedOutcome {
  outcome: SignalOutcome;
  spreadCostR: number;
}

// Аудит (синхронизация с демо-счётом): раньше спред сравнивался с
// расстоянием до signal.takeProfit — но take-profit больше не участвует в
// определении исхода (см. outcome-scheduler.ts::resolveOutcome), поэтому и
// здесь takeProfit больше нельзя использовать как точку отсчёта. Спред
// теперь сравнивается с фактическим движением цены на экспирации
// (expiryClosePrice vs entryPrice) — тем же движением, которое определило
// исход. Эта функция — источник обучающей метки для калибровочной модели
// (см. tick-store/outcomes.ts).
//
// BUGFIX (аудит 2026-09-13, "спред учитывался в калибровке, но не в
// балансе"): нижняя строка комментария выше раньше заканчивалась "на
// выплату демо-счёта спред не влияет" — это было верно на момент
// написания, но с этого фикса уже неверно: useDemoAccountStore.ts::
// resolveTrade() теперь применяет ТУ ЖЕ логику (движение <= спред → не
// победа, а тай) к реальному payout демо-счёта — независимой, отдельно
// реализованной копией (см. BUGFIX-комментарий в resolveTrade), не
// вызовом этой функции напрямую (эта функция типизирована под
// SignalOutcome/'timeout', а resolveTrade оперирует pnl/'tie' — разные
// доменные модели одного и того же исхода). Если меняешь пороговую
// геометрию здесь (`move <= spread`), проверь, не разошлась ли она с
// идентичной проверкой в resolveTrade — сейчас они спроектированы как
// зеркальные, но это два независимых места, а не одно.
export function applySpreadToOutcome(
  outcome: SignalOutcome,
  signal: Signal,
  spread: number,
  expiryClosePrice: number,
): SpreadAdjustedOutcome {
  const move = Math.abs(expiryClosePrice - signal.entryPrice);
  const spreadCostR = move > 0 ? spread / move : 0;

  if (outcome === 'win' && move <= spread) {
    // Движение цены не превышает спред — реального выигрыша по факту нет.
    return { outcome: 'timeout', spreadCostR };
  }
  return { outcome, spreadCostR };
}
